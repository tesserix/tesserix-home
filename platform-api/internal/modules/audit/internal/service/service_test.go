package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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

// q is a read with the bounds the handler defaults to, so a test that is not
// about the bounds does not have to state them.
func q(source string) Query {
	return Query{Source: source, Limit: 200, SinceHours: 720}
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
		{Slug: "mark8ly", BaseURL: srv.URL, Secret: "test-secret"},
	}), srv.Client())

	log, _ := testLogger()
	page, err := New(fed, []string{"mark8ly"}, log).Estate(context.Background(), op(), q(""))
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
		{Slug: "mark8ly", BaseURL: srv.URL, Secret: "test-secret"},
		{Slug: "kora", BaseURL: srv.URL, Secret: "test-secret"},
	}), srv.Client())

	log, _ := testLogger()
	page, err := New(fed, []string{"kora", "mark8ly"}, log).Estate(context.Background(), op(), q("mark8ly"))
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
	_, err := New(fed, []string{"mark8ly"}, log).Estate(context.Background(), op(), q("nope"))
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
		{Slug: "mark8ly", BaseURL: ok.URL, Secret: "test-secret"},
		{Slug: "kora", BaseURL: down.URL, Secret: "test-secret"},
	}), ok.Client())

	log, _ := testLogger()
	page, err := New(fed, []string{"kora", "mark8ly"}, log).Estate(context.Background(), op(), q(""))
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
		{Slug: "kora", BaseURL: "http://" + unreachable, Secret: "test-secret"},
	}), &http.Client{})

	log, buf := testLogger()
	page, err := New(fed, []string{"kora"}, log).Estate(context.Background(), op(), q(""))
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

// TestEstateNamespacesEveryRowIdWithItsSource is I1's regression guard.
//
// apps/web's producer has namespaced ids as `${source}:${id}` since it served
// this surface; a bare id on this transport means two products returning
// primary key `12` collide in a merged list keyed by id, and the console's
// dedupeIds starts rewriting ids in an integrity record. Nothing else catches
// it: domain.Entry.ID is a string, so a bare id parses and renders fine right
// up until two products are configured.
func TestEstateNamespacesEveryRowIdWithItsSource(t *testing.T) {
	srv := productServing(t, `{"data":[{"id":"12","action":"a","timestamp":"2026-08-22T10:00:00Z"}]}`)
	defer srv.Close()

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: srv.URL, Secret: "test-secret"},
	}), srv.Client())

	log, _ := testLogger()
	page, err := New(fed, []string{"mark8ly"}, log).Estate(context.Background(), op(), q(""))
	if err != nil {
		t.Fatalf("Estate: %v", err)
	}
	if len(page.Entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(page.Entries))
	}
	if got := page.Entries[0].ID; got != "mark8ly:12" {
		t.Errorf("ID = %q, want %q — a bare id collides with every other product's integer keys", got, "mark8ly:12")
	}
}

// TestEstateOverridesTheSourceAndIdAProductClaimsForAnother is the adversarial
// half, and it is a SECURITY property: the slug the call was made to wins over
// anything the body says. A product that could name itself "mark8ly" — in
// `source`, or by namespacing its own ids — could write rows into another
// product's history in the estate's audit log.
func TestEstateOverridesTheSourceAndIdAProductClaimsForAnother(t *testing.T) {
	srv := productServing(t, `{"data":[{"id":"mark8ly:9f2","source":"mark8ly","action":"tenant.suspended","timestamp":"2026-08-22T10:00:00Z"}]}`)
	defer srv.Close()

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "kora", BaseURL: srv.URL, Secret: "test-secret"},
	}), srv.Client())

	log, _ := testLogger()
	page, err := New(fed, []string{"kora"}, log).Estate(context.Background(), op(), q(""))
	if err != nil {
		t.Fatalf("Estate: %v", err)
	}
	if len(page.Entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(page.Entries))
	}
	if got := page.Entries[0].Source; got != "kora" {
		t.Errorf("Source = %q, want kora — a product must not be able to name itself into another product's rows", got)
	}
	if got := page.Entries[0].ID; got != "kora:mark8ly:9f2" {
		t.Errorf("ID = %q, want %q — the id namespace is the caller's to assign, not the product's to claim", got, "kora:mark8ly:9f2")
	}
}

// TestEstateRefusesWhenNoProductsAreConfigured is I2's guard. An empty
// registry fanned out to nothing and returned a 200 with an empty timeline,
// which reads to an operator as "no audit events" — the same confusion the
// unknown-source refusal above already refuses to create.
func TestEstateRefusesWhenNoProductsAreConfigured(t *testing.T) {
	fed := federation.NewClient(federation.NewRegistry(nil), http.DefaultClient)

	log, _ := testLogger()
	_, err := New(fed, nil, log).Estate(context.Background(), op(), q(""))
	if !errors.Is(err, ErrNotInstrumented) {
		t.Fatalf("err = %v, want ErrNotInstrumented — an unconfigured registry must not answer like a quiet estate", err)
	}
}

// A configured product that fails is NOT the unconfigured case: it stays a
// 200 with a populated failures list. Pinned because the two are one `if`
// apart, and collapsing them would hide a live outage behind "not
// instrumented".
func TestEstateStillDegradesWhenAConfiguredProductFails(t *testing.T) {
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer down.Close()

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "kora", BaseURL: down.URL, Secret: "test-secret"},
	}), down.Client())

	log, _ := testLogger()
	page, err := New(fed, []string{"kora"}, log).Estate(context.Background(), op(), q(""))
	if err != nil {
		t.Fatalf("every configured source failing is still an answer, not an error: %v", err)
	}
	if len(page.Failures) != 1 {
		t.Fatalf("failures = %v, want one naming kora", page.Failures)
	}
}

// TestEstateAsksEachProductForABoundedWindow is I3's guard: without it every
// product is asked for its entire audit log, and the federation client's 1 MiB
// limit truncates the answer mid-JSON into a generic "invalid response".
func TestEstateAsksEachProductForABoundedWindow(t *testing.T) {
	asked := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked <- r.URL.String()
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer srv.Close()

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: srv.URL, Secret: "test-secret"},
	}), srv.Client())

	log, _ := testLogger()
	_, err := New(fed, []string{"mark8ly"}, log).
		Estate(context.Background(), op(), Query{Limit: 200, SinceHours: 720})
	if err != nil {
		t.Fatalf("Estate: %v", err)
	}

	got := <-asked
	if !strings.HasPrefix(got, "/admin/audit-logs?") {
		t.Fatalf("path = %q, want the contract's endpoint", got)
	}
	if !strings.Contains(got, "limit=200") || !strings.Contains(got, "since_hours=720") {
		t.Errorf("path = %q, want limit and since_hours — an unbounded read is truncated mid-JSON at 1 MiB", got)
	}
}
